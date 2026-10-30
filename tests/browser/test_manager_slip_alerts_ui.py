"""MANAGER-SLIP-ALERTS in a real browser at 390 px: the real employee.html Command center (hub_shell_harness.py) with a
synthetic late job and a not-en-route job. The clock is fixed at 2026-09-22 12:00 in Denver and the browser runs in
Asia/Tokyo to prove Denver days. window.Notification is a stub that records each alert, so a tap can be simulated.
Checked:
  - with GET /api/employee-hub slipAlerts on, the owner who turned on browser alerts gets one alert per slip, and not again;
  - the alert text has the customer and times and no money;
  - tapping an alert from another screen opens Today on that job's Field agenda row, highlighted and in view;
  - /employee.html?view=today&job=<id> (the service worker's way in) opens the same row;
  - switched off, no alert; crew get none;
  - no sideways scroll at 390 px.
Every non-127.0.0.1 request is aborted or stubbed. Screenshots land in test-results/."""
import json, unittest
from playwright.sync_api import expect
from hub_shell_harness import HubShell, RESULTS, DAY, MANAGER, CREW, collections

ALERTS = r'''(function(){
window.__alerts=[];
class SyntheticAlert{static permission='granted';static async requestPermission(){return'granted'}
  constructor(title,options){this.title=title;this.options=options||{};window.__alerts.push(this)}close(){this.closed=true}}
window.Notification=SyntheticAlert;
try{localStorage.setItem('egc_browser_alerts','on')}catch{}
})();'''


def job(id, customer, time, **extra):
    return {'id': id, 'type': 'job', 'customer': customer, 'phone': '9705550100', 'address': f'{id} Synthetic Way, Fort Collins, CO', 'date': DAY, 'time': time, 'endDate': DAY,
            'endTime': '15:00', 'status': 'scheduled', 'pipelineStatus': 'scheduled', 'assignedTo': 'ZacB', 'assignedCrew': ['zacb'], 'crewNeeded': 1, 'priceQuoted': 2250, 'total': 2250,
            'syncStatus': 'synced', 'notify': False, **extra}


class ManagerSlipAlertTests(HubShell, unittest.TestCase):
    jobs = [job('late-job', 'Synthetic Late Garage', '10:00'), job('soon-job', 'Synthetic Soon Garage', '12:20'),
            job('rolling-job', 'Synthetic Rolling Garage', '10:00', dispatchedAt=DAY + 'T15:50:00Z'),
            *[job(f'filler-{n}', f'Synthetic Later Garage {n}', '16:00') for n in range(6)]]

    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()

    def setUp(self): self.errors = []; self.slip = True
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def route(self, route):
        request = route.request
        if request.url.split('?')[0].endswith('/api/employee-hub') and request.method == 'GET' and '127.0.0.1' in request.url:
            self.calls.append(('GET', '/api/employee-hub', ''))
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'collections': collections(self.profile), 'accounts': [], 'slipAlerts': self.slip}))
            return
        super().route(route)

    def start_page(self, query='view=today', profile=MANAGER):
        page = self.open_page(390, 844, profile)
        page.add_init_script(ALERTS)
        page.goto(f'{self.url}/employee.html?{query}')
        page.wait_for_function('document.querySelector("#ops-main")?.children.length>0 && window.EGCHubScreens && !document.querySelector(".hub-screen-loading")')
        return page

    def alerts(self, page):
        # Only the slip alerts: the Hub's own announcement and crew-chat alerts (#212) share the stub.
        return page.evaluate("window.__alerts.filter(a=>String(a.options.tag||'').startsWith('egc-slip-')).map(a=>({title:a.title,body:a.options.body,tag:a.options.tag,data:a.options.data}))")

    def wait_still(self, page):
        # The Hub scrolls smoothly: wait until the page has stopped moving.
        for _ in range(40):
            before = page.evaluate('scrollY'); page.wait_for_timeout(250)
            if page.evaluate('scrollY') == before: return
        self.fail('the page kept scrolling')

    def assert_phone(self, page):
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'), 'no sideways scroll at 390 px')

    def test_one_alert_per_slip_and_a_tap_opens_the_row(self):
        page = self.start_page()
        page.wait_for_function('window.__alerts.length>=2')
        page.wait_for_timeout(300)
        shown = self.alerts(page)
        self.assertEqual(sorted(row['title'] for row in shown), ['Crew late: Synthetic Late Garage', 'Not en route: Synthetic Soon Garage'],
                         'the rolling job is en route, so its late flag sends nothing')
        late = next(row for row in shown if row['title'].startswith('Crew late'))
        self.assertEqual(late['body'], 'Due by 10:15 AM and not arrived. Tap to open the Field agenda.')
        self.assertEqual(late['data'], {'view': 'today', 'job': 'late-job'})
        for row in shown: self.assertNotIn('$', row['title'] + row['body'])
        # The Field agenda still shows the rolling job's chip: only the alert waits for the crew.
        expect(page.locator('[data-agenda-job="rolling-job"] .ops-field-flags')).to_contain_text('Late')
        # Every later refresh finds the same slips and shows nothing new.
        page.evaluate("opsGo('my_day')")
        page.wait_for_timeout(500)
        self.assertEqual(len(self.alerts(page)), 2)
        # Tapping the late alert from My day opens Today on that job's row.
        page.evaluate("window.__alerts.find(a=>a.options.tag===%s).onclick()" % json.dumps(late['tag']))
        card = page.locator('article.ops-agenda-focus')
        expect(card).to_have_count(1)
        expect(card).to_contain_text('Synthetic Late Garage')
        expect(card).to_be_in_viewport()
        self.assertTrue(page.evaluate("window.__alerts.find(a=>a.options.tag===%s).closed" % json.dumps(late['tag'])))
        # The highlight survives the Hub's own re-renders.
        page.evaluate("opsAgendaDay(0)")
        expect(page.locator('article.ops-agenda-focus')).to_contain_text('Synthetic Late Garage')
        self.assert_phone(page)
        page.screenshot(path=str(RESULTS / 'manager-slip-alert-390.png'), full_page=False)

    def test_the_service_worker_link_opens_the_same_row(self):
        self.slip = False
        page = self.start_page('view=today&job=soon-job')
        card = page.locator('article.ops-agenda-focus')
        expect(card).to_contain_text('Synthetic Soon Garage')
        expect(card).to_be_in_viewport()
        self.assert_phone(page)

    def test_the_row_stays_in_view_through_a_late_render_until_the_viewer_scrolls(self):
        self.slip = False
        page = self.start_page('view=today&job=soon-job')
        card = page.locator('article.ops-agenda-focus')
        expect(card).to_be_in_viewport(ratio=1)
        # A render that lands above the agenda afterwards (home widgets or review alerts loading, a refreshed agenda)
        # replaces the screen 1,000 px taller: the row is put back in view.
        late = "()=>{const host=document.querySelector('#ops-main');host.innerHTML='<div style=\"height:1000px\"></div>'+host.innerHTML}"
        page.evaluate(late)
        expect(card).to_be_in_viewport(ratio=1)
        self.wait_still(page)
        # Once the viewer scrolls (a finger drags the page back to the top), the position is theirs: a later render does
        # not take it back. A phone context does not scroll on mouse wheel events, so the drag is the touch plus its scroll.
        page.evaluate("()=>{document.querySelector('#ops-main').dispatchEvent(new Event('touchstart',{bubbles:true}));scrollTo({top:0,behavior:'instant'})}")
        self.wait_still(page)
        self.assertEqual(page.evaluate('scrollY'), 0)
        page.evaluate(late)
        page.wait_for_timeout(1500)
        self.assertEqual(page.evaluate('scrollY'), 0)
        expect(card).not_to_be_in_viewport()
        self.assert_phone(page)

    def test_switched_off_and_crew_get_none(self):
        self.slip = False
        page = self.start_page()
        expect(page.locator('[data-agenda-job="late-job"] .ops-field-flags')).to_contain_text('Late')
        page.wait_for_timeout(800)
        self.assertEqual(self.alerts(page), [], 'the server said no: the flags show, no alert')
        self.close_page()
        self.slip = True
        crew = self.start_page('view=my_day', CREW)
        crew.wait_for_timeout(800)
        self.assertEqual(self.alerts(crew), [], 'crew never get one, even if the server flag were on')


if __name__ == '__main__':
    unittest.main()
