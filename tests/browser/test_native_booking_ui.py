"""Native Hub schedule form against synthetic Firestore; never accesses customer services."""
import json, os, pathlib, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

ROOT=pathlib.Path(__file__).resolve().parents[2]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        if self.path=='/':
            body='''<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-suite.css"></head><body><main id="ops-main"></main><script>let jobsCache=[]; window.hubFetch=fetch; sessionStorage.setItem('egc_u','ZacB');sessionStorage.setItem('egc_business_access','true');sessionStorage.setItem('egc_role','owner');</script><script src="/fixture-suite.js"></script></body></html>'''
        elif self.path=='/fixture-suite.js':
            source=(ROOT/'employee-suite.js').read_text(encoding='utf-8')
            body=source.rsplit('})();',1)[0]+'window.__nativeTest={S,render,syncPayload};})();'
        else: return super().do_GET()
        self.send_response(200);self.send_header('Content-Type','application/javascript' if self.path.endswith('.js') else 'text/html');self.end_headers();self.wfile.write(body.encode())

class NativeBookingBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)));threading.Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.url=f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,args=['--no-sandbox'],**({'executable_path':os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}))
    @classmethod
    def tearDownClass(cls): cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close()
    def setUp(self):
        self.context=self.browser.new_context(viewport={'width':1360,'height':1000},timezone_id='Asia/Tokyo');self.page=self.context.new_page();self.errors=[];self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        self.page.route('**/api/**',lambda route:route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'synthetic_provider_unavailable'})))
        self.page.goto(self.url)
        self.page.evaluate('''() => {
          window.fixture={rows:new Map(),writes:[],ambiguous:true,readOffline:true};
          const snap=key=>({exists:fixture.rows.has(key),data:()=>fixture.rows.get(key)});
          window.db={collection:name=>({doc:id=>({key:name+'/'+id,get:async()=>{if(fixture.readOffline)throw Error('offline');return snap(name+'/'+id)},set:async value=>fixture.rows.set(name+'/'+id,{...fixture.rows.get(name+'/'+id),...value})})}),runTransaction:async fn=>{
            const writes=[];const result=await fn({get:async ref=>snap(ref.key),set:(ref,value)=>writes.push([ref.key,value])});
            for(const [key,value]of writes){fixture.rows.set(key,{...fixture.rows.get(key),...value});fixture.writes.push({key,value});}
            if(fixture.ambiguous){fixture.ambiguous=false;throw Error('response_lost_after_commit')}return result;
          }};
          __nativeTest.S.active='schedule';__nativeTest.render();opsOpenBooking('2026-09-22');
        }''')
    def tearDown(self): self.assertEqual(self.errors,[]);self.context.close()
    def test_lost_save_response_preserves_one_visit_and_denver_time(self):
        self.page.get_by_label('Customer / label',exact=True).fill('Synthetic customer')
        self.page.get_by_label('Address',exact=True).fill('123 Synthetic St')
        self.page.get_by_label('Start',exact=True).fill('14:15');self.page.get_by_label('End',exact=True).fill('15:00')
        self.page.get_by_role('button',name='Save + sync',exact=True).click()
        expect(self.page.get_by_role('button',name='Retry save',exact=True)).to_be_visible()
        first=self.page.evaluate('fixture.writes.filter(x=>!x.key.includes("_egc_")).map(x=>({id:x.value.id,key:x.value.syncIdempotencyKey}))')
        self.assertEqual(len(first),1)
        expect(self.page.get_by_label('Customer / label',exact=True)).to_have_value('Synthetic customer')
        self.page.evaluate('fixture.readOffline=false')
        self.page.get_by_role('button',name='Retry save',exact=True).click()
        expect(self.page.get_by_role('dialog',name='Schedule work')).to_have_count(0)
        result=self.page.evaluate('({writes:fixture.writes.filter(x=>!x.key.includes("_egc_")).length,jobs:jobsCache.map(j=>({id:j.id,key:j.syncIdempotencyKey,status:j.syncStatus,pending:j.providerScheduleCheck.status,start:__nativeTest.syncPayload(j).start_time}))})')
        self.assertEqual(result['writes'],1);self.assertEqual(len(result['jobs']),1)
        self.assertEqual(result['jobs'][0],{**first[0],'status':'error','pending':'pending','start':'2026-09-22T20:15:00.000Z'})
    def test_ambiguous_dst_time_is_visible_and_creates_no_visit(self):
        self.page.get_by_label('Customer / label',exact=True).fill('Synthetic DST customer')
        self.page.get_by_label('Date',exact=True).fill('2026-11-01');self.page.get_by_label('Start',exact=True).fill('01:30');self.page.get_by_label('End',exact=True).fill('02:30')
        self.page.get_by_role('button',name='Save + sync',exact=True).click()
        expect(self.page.locator('#ops-booking-status')).to_contain_text('Daylight-saving transition')
        self.assertEqual(self.page.evaluate('fixture.writes.length'),0)

if __name__=='__main__': unittest.main(verbosity=2)
