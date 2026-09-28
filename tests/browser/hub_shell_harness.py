"""Serves the real employee.html with Firebase, Maps and fonts stubbed and every Hub API routed to synthetic
fixtures. No production service is reached: every non-127.0.0.1 request is fulfilled with a stub or aborted."""
import copy, json, os, pathlib, threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'
DAY = '2026-09-22'
NOW = DAY + 'T18:00:00Z'
MANAGER = {'ok': True, 'user': 'ZacB', 'displayName': 'Synthetic Owner', 'role': 'owner', 'businessAccess': True, 'payType': 'owner', 'hourlyRate': 0}
CREW = {'ok': True, 'user': 'Synthetic.Crew', 'displayName': 'Synthetic Crew', 'role': 'crew', 'businessAccess': False, 'payType': 'hourly', 'hourlyRate': 20}
DONE = {'onboardingCompletedAt': '2026-09-01T15:00:00Z', 'onboardingVersion': '2026-09-location-v2'}
JOBS = [
    {'id': 'job-today', 'type': 'job', 'customer': 'Synthetic Johnson Garage', 'phone': '9705550100', 'email': 'synthetic@example.invalid', 'address': '123 Synthetic Way, Fort Collins, CO',
     'date': DAY, 'time': '08:00', 'endDate': DAY, 'endTime': '11:00', 'status': 'scheduled', 'pipelineStatus': 'scheduled', 'assignedTo': 'Synthetic.Crew', 'assignedCrew': ['synthetic.crew'],
     'crewNeeded': 2, 'priceQuoted': 2250, 'total': 2250, 'notes': 'Keep the workbench.', 'serviceType': 'Garage cleanout', 'syncStatus': 'synced', 'shiftPickupEnabled': True, 'notify': False,
     'customerDecisions': [{'id': 'decision-1', 'title': 'Remove the synthetic cabinet?', 'status': 'pending'}]},
    {'id': 'walk-today', 'type': 'walkthrough', 'customer': 'Synthetic Walkthrough Lead', 'phone': '9705550101', 'address': '456 Synthetic Ave, Fort Collins, CO', 'date': DAY, 'time': '13:00',
     'endDate': DAY, 'endTime': '14:00', 'status': 'scheduled', 'syncStatus': 'synced', 'notify': False},
    {'id': 'job-done', 'type': 'job', 'customer': 'Synthetic Finished Garage', 'phone': '9705550102', 'address': '789 Synthetic Ct, Loveland, CO', 'date': '2026-09-15', 'time': '09:00', 'endDate': '2026-09-15',
     'endTime': '12:00', 'status': 'completed', 'completedAt': '2026-09-15T19:00:00Z', 'total': 1800, 'priceQuoted': 1800, 'assignedCrew': ['synthetic.crew'], 'assignedTo': 'Synthetic.Crew', 'notify': False,
     'syncStatus': 'synced', 'invoice': {'number': 'INV-1001', 'status': 'issued', 'dueDate': '2026-09-30', 'amount': 1800}, 'closeoutSyncStatus': 'error', 'closeoutSyncPayload': {'tool': 'post_job'},
     'closeoutSyncNextRetryAt': '2099-01-01T00:00:00Z', 'rebookingRequests': [{'id': 'rebook-1', 'status': 'pending', 'kind': 'repeat'}]},
]
# /api/staff-directory for the Team page section and the registered Staff directory screen (TEAM-UI).
STAFF = {'ok': True, 'authority': 'employee_hub', 'timeZone': 'America/Denver', 'today': DAY,
         'viewer': {'user': 'ZacB', 'capabilities': ['dispatch.write', 'time.approve', 'pay.manage', 'accounts.approve', 'customer.send', 'followups.own']},
         'catalog': {'version': 'synthetic-skills', 'skills': [{'id': 'cleanout', 'label': 'Garage cleanout'}, {'id': 'customer_phone', 'label': 'Customer phone follow-up'}], 'levels': ['trainee', 'proficient', 'lead'],
                     'roles': ['owner', 'manager', 'crew_lead', 'crew', 'sales', 'phone'], 'days': ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']},
         'people': [{'username': 'Synthetic.Crew', 'displayName': 'Synthetic Crew', 'source': 'employee_account', 'accountStatus': 'approved', 'staffRoles': ['crew', 'phone'], 'staffRolesSource': 'account', 'primaryRole': 'phone',
                     'skills': [{'id': 'customer_phone', 'level': 'lead', 'verifiedBy': 'zacb', 'verifiedAt': '2026-09-10T16:00:00Z'}],
                     'weeklyAvailability': {'mon': [{'start': '08:00', 'end': '17:00'}], 'tue': [], 'wed': [{'start': '18:00', 'end': '24:00'}], 'thu': [], 'fri': [], 'sat': [], 'sun': []}, 'weeklyAvailabilityNeedsReview': False,
                     'pay': {'current': {'hourlyRate': 20, 'payType': 'hourly', 'overtimeMultiplier': 1.5, 'effectiveFrom': '2026-09-01', 'source': 'pay_rates', 'drift': False},
                             'upcoming': [{'effectiveFrom': '2026-10-01', 'hourlyRate': 22, 'payType': 'hourly', 'overtimeMultiplier': 1.5}],
                             'schedule': [{'effectiveFrom': '2026-09-01', 'hourlyRate': 20, 'payType': 'hourly', 'overtimeMultiplier': 1.5}, {'effectiveFrom': '2026-10-01', 'hourlyRate': 22, 'payType': 'hourly', 'overtimeMultiplier': 1.5}], 'needsReview': False},
                     'history': [], 'revision': 'rev-staff-1', 'profileNeedsReview': False}],
         'coverage': {'complete': True, 'asOf': NOW}}
FIREBASE = r'''(function(){
const snap=name=>({docs:(name==='jobs'?(window.__egcJobs||[]):[]).map(row=>({id:row.id,data:()=>({...row})}))});
const ref=name=>({onSnapshot(next){setTimeout(()=>next(snap(name)),0);return()=>{};},add:async()=>({id:'synthetic'}),get:async()=>snap(name),where(){return this;},orderBy(){return this;},limit(){return this;},
  doc(){return{set:async()=>{},update:async()=>{},delete:async()=>{},get:async()=>({exists:false,data:()=>({})})};}});
const db={collection:ref,batch:()=>({set(){},update(){},delete(){},commit:async()=>{}}),runTransaction:async()=>{throw new Error('Synthetic transactions are unavailable');}};
// The audit log stamps serverAt with FieldValue.serverTimestamp(), so the compat namespace carries it.
window.firebase={initializeApp(){},firestore:Object.assign(()=>db,{FieldValue:{serverTimestamp:()=>({synthetic:'serverTimestamp'})}}),auth:()=>({signInWithCustomToken:async()=>({}),signOut:async()=>{}})};
})();'''
FIXTURE_SCREEN = r'''(function(){
'use strict';
let root=null,dirty=false,mounts=0;
function mount(host,ctx){
  mounts++;const {h,button,field}=window.EGCHubKit;
  const phone=field({label:'Synthetic callback phone',name:'phone',type:'tel',autocomplete:'tel',help:'Typing here marks the screen as having unsaved changes.'});
  phone.querySelector('input').addEventListener('input',event=>{dirty=Boolean(event.target.value);});
  const result=h('p',{role:'status','data-fixture-result':''});
  root=h('section',{class:'hub-screen fixture-screen'},
    h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'FIXTURE'),h('h1',{},'Fixture screen'),h('p',{},'Mounted through the Hub screen registry for '+ctx.identity+'.')),
      h('div',{class:'hub-actions'},button('Confirm with dialog',async()=>{const values=await ctx.askAction({title:'Synthetic confirmation',fields:[{name:'phone',label:'Confirm phone',type:'tel',autocomplete:'tel'}],confirmLabel:'Confirm'});result.textContent=values?'Confirmed '+values.phone:'Cancelled';},'primary'),button('Go to customers',()=>ctx.go('customers')))),
    h('div',{class:'hub-card'},phone,result,h('p',{'data-fixture-mounts':''},'Mounts: '+mounts)),
    h('div',{class:'hub-notice warning'},'Synthetic notice text that is long enough to wrap on a narrow phone screen without scrolling sideways.'),
    h('div',{class:'hub-table-scroll'},h('table',{},h('thead',{},h('tr',{},['Customer','Visit','Crew','Balance'].map(text=>h('th',{},text)))),h('tbody',{},h('tr',{},['Synthetic Johnson Garage','2026-09-22 08:00','Synthetic Crew','$2,250.00'].map(text=>h('td',{},text)))))));
  host.append(root);
}
function unmount(){root?.remove();root=null;dirty=false;}
window.EGCFixtureScreen={mount,unmount,canLeave:()=>!dirty,refresh(){}};
})();'''
REGISTER = "\nwindow.EGCHubScreens.register({id:'fixture_screen',group:'SYSTEM',label:'Fixture screen',iconPath:'M4 4h16v16H4z',crewVisible:true,load:{js:'fixture-screen.js',v:'test'},module:'EGCFixtureScreen'});\n"


def collections(profile):
    me = profile['user']
    return {
        'profiles': [{'id': 'zacb', 'username': 'ZacB', 'displayName': 'Synthetic Owner', 'role': 'owner', 'status': 'active', 'hourlyRate': 0, **DONE},
                     {'id': 'synthetic.crew', 'username': 'Synthetic.Crew', 'displayName': 'Synthetic Crew', 'role': 'crew', 'status': 'active', 'hourlyRate': 20, 'jobTitle': 'Field crew', **DONE}],
        'timeEntries': [{'id': 'time-1', 'employee': me, 'status': 'submitted', 'approvalStatus': 'pending', 'clockInAt': DAY + 'T14:00:00Z', 'clockOutAt': DAY + 'T17:00:00Z', 'hourlyRate': 20, 'jobLabel': 'Synthetic Johnson Garage'}],
        'announcements': [{'id': 'announcement-1', 'title': 'Synthetic crew update', 'body': 'Meet at the shop at 7 with gloves and water.', 'priority': 'normal', 'createdAt': '2026-09-21T15:00:00Z', 'createdBy': 'ZacB', 'readBy': [], 'status': 'active'}],
        'requests': [{'id': 'request-1', 'employee': 'Synthetic.Crew', 'type': 'time_off', 'status': 'pending', 'date': '2026-09-25', 'reason': 'Synthetic appointment', 'createdAt': '2026-09-20T15:00:00Z'}],
        'incidents': [], 'equipment': [], 'training': [],
        'teamMessages': [{'id': 'message-1', 'body': 'Synthetic hello team', 'sender': 'ZacB', 'senderName': 'Synthetic Owner', 'createdAt': DAY + 'T15:00:00Z', 'updatedAt': DAY + 'T15:00:00Z', 'status': 'active'}],
        'jobMessages': [], 'messageReads': [],
    }


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/employee-hub-screens.js': body = (ROOT / 'employee-hub-screens.js').read_text(encoding='utf-8') + REGISTER
        elif path == '/fixture-screen.js': body = FIXTURE_SCREEN
        else: return super().do_GET()
        self.send_response(200); self.send_header('Content-Type', 'application/javascript'); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(body.encode())


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address): pass  # a closed test page may drop a static request mid-response


class HubShell:
    """Mixin for unittest.TestCase classes; call start()/stop() from setUpClass/tearDownClass."""
    @classmethod
    def start(cls):
        cls.server = Server(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
        RESULTS.mkdir(exist_ok=True)
    @classmethod
    def stop(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def open_page(self, width=390, height=844, profile=MANAGER):
        mobile = width < 700
        self.profile = profile; self.calls = []; self.api_failures = {}; self.extra_team_messages = []
        if not hasattr(self, 'errors'): self.errors = []
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo', is_mobile=mobile, has_touch=mobile, bypass_csp=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(7000)
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.clock.install(time=NOW)
        self.page.add_init_script('window.__egcJobs=' + json.dumps(JOBS) + ';')
        self.page.route('**/*', self.route)
        return self.page

    def close_page(self):
        if getattr(self, 'context', None): self.context.close()
        self.context = None

    def open(self, view, width=390, height=844, profile=MANAGER):
        page = self.open_page(width, height, profile)
        page.goto(f'{self.url}/employee.html?view={view}')
        page.wait_for_function('document.querySelector("#ops-main")?.children.length>0 && window.EGCHubScreens && !document.querySelector(".hub-screen-loading")')
        return page

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1':
            if parsed.hostname == 'www.gstatic.com' and parsed.path.endswith('/firebase-app-compat.js'):
                route.fulfill(status=200, content_type='application/javascript', body=FIREBASE); return
            if parsed.hostname == 'www.gstatic.com':
                route.fulfill(status=200, content_type='application/javascript', body=''); return
            route.abort(); return
        if not parsed.path.startswith('/api/'): route.continue_(); return
        self.calls.append((request.method, parsed.path, parsed.query))
        def send(body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
        path, query = parsed.path, parse_qs(parsed.query)
        if path in self.api_failures: send({'ok': False, 'error': self.api_failures[path]}, 503); return
        if path == '/api/hub-auth':
            send(self.profile if request.method in ('GET', 'POST') else {'ok': True}); return
        if path == '/api/firebase-session': send({'ok': True, 'token': 'synthetic-token'}); return
        if path == '/api/integration-status': send({'ok': True, 'status': {'highlevel': True, 'firebase': True, 'employeeAccounts': True, 'customerPortal': True}}); return
        if path == '/api/highlevel':
            view = query.get('view', [''])[0]
            if view == 'command':
                send({'ok': True, 'pipelines': [{'id': 'pipeline-1', 'stages': [{'id': 'stage-1', 'name': 'New lead'}]}], 'leadResetAt': '2026-09-03T00:00:00Z',
                      'opportunities': [{'id': 'opportunity-1', 'name': 'Synthetic lead', 'pipelineStageId': 'stage-1', 'monetaryValue': 2250, 'status': 'open', 'source': 'Website', 'contact': {'name': 'Synthetic Lead', 'phone': '9705550111'}}]}); return
            if view == 'contacts': send({'ok': True, 'contacts': [{'id': 'contact-1', 'name': 'Synthetic Customer', 'phone': '9705550100'}]}); return
            if request.method == 'GET': send({'ok': True, 'events': []}); return
            send({'ok': False, 'error': 'Synthetic HighLevel is offline'}, 503); return
        if path == '/api/employee-hub':
            if request.method == 'GET':
                data = collections(self.profile); data['teamMessages'] += copy.deepcopy(self.extra_team_messages)
                send({'ok': True, 'collections': data, 'accounts': []}); return
            body = request.post_data_json or {}; send({'ok': True, 'record': body.get('data') or {}}); return
        if path == '/api/employee-accounts': send({'ok': True, 'accounts': []}); return
        if path == '/api/crew-jobs': send({'ok': True, 'jobs': copy.deepcopy(JOBS)}); return
        if path == '/api/field-jobs': send({'ok': True, 'jobs': [{**JOBS[0], 'crewMembers': [{'id': 'synthetic.crew', 'name': 'Synthetic Crew'}], 'crewLead': 'synthetic.crew', 'vehicleName': 'Synthetic truck'}], 'generatedAt': DAY + 'T18:00:00Z'}); return
        if path == '/api/dispatch' and request.method == 'GET':
            start = query.get('startDate', [DAY])[0]; end = query.get('endDate', ['2026-09-29'])[0]
            send({'ok': True, 'viewer': {'id': 'zacb'}, 'timeZone': 'America/Denver', 'jobs': [{**JOBS[0], 'revision': 'rev-1', 'startAt': DAY + 'T08:00:00-06:00', 'endAt': DAY + 'T11:00:00-06:00'}],
                  'roster': [{'id': 'synthetic.crew', 'name': 'Synthetic Crew', 'role': 'crew'}, {'id': 'zacb', 'name': 'Synthetic Owner', 'role': 'owner'}], 'crews': [], 'vehicles': [], 'availability': [],
                  'warnings': [], 'coverage': {'complete': True, 'asOf': DAY + 'T18:00:00Z'}, 'startDate': start, 'endDate': end}); return
        if path == '/api/crew-availability' and request.method == 'GET':
            send({'ok': True, 'timeZone': 'America/Denver', 'employee': {'id': 'synthetic.crew', 'name': 'Synthetic Crew'}, 'startDate': DAY, 'endDate': '2026-10-22', 'availability': [], 'exceptions': [], 'coverage': {'complete': True}}); return
        if path == '/api/staff-directory' and request.method == 'GET': send(copy.deepcopy(STAFF)); return
        if path == '/api/operations' and request.method == 'GET':
            send({'ok': True, 'enabled': False, 'actor': {'id': 'zacb', 'role': 'owner', 'kind': 'human'}, 'owners': [{'id': 'zacb', 'name': 'Synthetic Owner', 'role': 'owner'}]}); return
        send({'ok': False, 'error': 'Synthetic service unavailable'}, 503)

    def nav_views(self):
        return self.page.evaluate("[...document.querySelectorAll('.ops-nav [data-ops-tab]')].map(button=>button.dataset.opsTab)")

    def go(self, view):
        self.page.evaluate('view=>opsGo(view)', view)
        self.page.wait_for_function('view=>new URLSearchParams(location.search).get("view")===view', arg=view)
        self.page.wait_for_function('!document.querySelector(".hub-screen-loading")')

    def no_horizontal_scroll(self):
        return self.page.evaluate('''()=>{const html=document.documentElement,body=document.body,before=[html.style.overflowX,body.style.overflowX];html.style.overflowX='visible';body.style.overflowX='visible';
          const width=html.scrollWidth,wide=[...document.querySelectorAll('.ops-shell *')].filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.right>innerWidth+1&&s.position!=='fixed'&&!el.closest('.ops-rail')&&!el.closest('[style*="overflow"],.hub-table-scroll,.ops-fly-row,.ops-week,.dp-scroll,.ac-scroll')}).slice(0,5).map(el=>el.tagName+'.'+String(el.className).slice(0,50)+' right='+Math.round(el.getBoundingClientRect().right));
          [html.style.overflowX,body.style.overflowX]=before;return{width,viewport:innerWidth,wide};}''')

    def small_inputs(self, scope='.ops-shell, #ops-hub-layer, .ops-modal'):
        return self.page.evaluate('''scope=>[...document.querySelectorAll(scope)].flatMap(root=>[...root.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea')])
          .filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&!el.closest('[inert]')&&parseFloat(s.fontSize)<16})
          .map(el=>el.tagName.toLowerCase()+'[name='+(el.name||'')+'].'+String(el.className||'').slice(0,40)+' '+getComputedStyle(el).fontSize)''', scope)

    def small_targets(self, scope='.ops-shell, #ops-hub-layer, .ops-modal'):
        return self.page.evaluate('''scope=>{const out=[];const seen=new Set();
          const shown=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&!el.closest('[inert]')};
          const inlineText=a=>{if(getComputedStyle(a).display!=='inline')return false;const block=a.parentElement;return Boolean(block)&&block.textContent.trim().length>a.textContent.trim().length};
          for(const root of document.querySelectorAll(scope))for(const el of root.querySelectorAll('button,a[href],select,input[type=checkbox],input[type=radio]')){
            const target=el.matches('input')?(el.closest('label')||el):el;if(seen.has(target))continue;seen.add(target);
            if(!shown(target)||el.matches('a')&&inlineText(el)||el.matches('.ops-scrim,.ops-modal-scrim'))continue;
            const r=target.getBoundingClientRect();if(r.height<44-0.5)out.push(target.tagName.toLowerCase()+'.'+String(target.className||'').trim().replace(/\\s+/g,'.').slice(0,60)+' "'+String(target.textContent||target.getAttribute('aria-label')||'').trim().slice(0,30)+'" '+Math.round(r.height)+'px');}
          return out;}''', scope)
