// Device projects for mobile-first acceptance. Install the runner without touching package.json:
//   npm install --no-save --ignore-scripts @playwright/test@1.63.0 playwright@1.63.0
//   PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome npx playwright test -c tests/e2e/playwright.config.mjs
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {defineConfig,devices} from '@playwright/test';
import {e2eWorkers} from './helpers/workers.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
// Workers re-evaluate this file with the main process environment, so the port
// chosen here is shared by every worker and parallel checkouts never collide.
if(!process.env.EGC_E2E_PORT)process.env.EGC_E2E_PORT=String(await new Promise((done,fail)=>{const server=createServer();server.once('error',fail);server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>done(port));});}));
const port=Number(process.env.EGC_E2E_PORT),baseURL=`http://127.0.0.1:${port}`;
const HUB_SHELL=/hub-shell-mobile\.spec\.mjs$/;
const chromium={browserName:'chromium',launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']}};

export default defineConfig({
 testDir:'.',testMatch:/.*\.spec\.mjs$/,fullyParallel:true,forbidOnly:!!process.env.CI,retries:0,
 workers:e2eWorkers(),timeout:30000,expect:{timeout:6000},
 outputDir:root+'test-results/e2e',
 reporter:[['list'],['json',{outputFile:root+'test-results/e2e-report.json'}]],
 globalTeardown:'./helpers/allowlist.mjs',
 use:{baseURL,timezoneId:'America/Denver',locale:'en-US',trace:process.env.CI?{mode:'retain-on-failure',screenshots:false}:'off',screenshot:'off',serviceWorkers:'block'},
 webServer:{command:'node scripts/visual-audit-server.mjs',cwd:root,url:baseURL+'/index.html',env:{EGC_VISUAL_AUDIT_PORT:String(port)},reuseExistingServer:process.env.EGC_E2E_REUSE_SERVER==='1',timeout:20000,stdout:'ignore',stderr:'pipe'},
 projects:[
  {name:'iphone-375',use:{...devices['iPhone 13'],...chromium,viewport:{width:375,height:812},deviceScaleFactor:3}},
  {name:'android-pixel7',testIgnore:HUB_SHELL,use:{...devices['Pixel 7'],...chromium}},
  // Touch tablet (iPad Mini, 768x1024) for the public pages only; the Hub shells are phone-first.
  {name:'tablet-768',testMatch:/public-pages\.spec\.mjs$/,use:{...devices['iPad Mini'],...chromium,viewport:{width:768,height:1024}}},
  {name:'desktop-1440',use:{...devices['Desktop Chrome'],...chromium,viewport:{width:1440,height:900}}},
  // The signed-in Employee Hub shell (MOBILE-HUB) also runs on the smallest phone, today's phones, a landscape phone,
  // both iPad orientations (touch) and a 1366x768 laptop.
  {name:'phone-320',testMatch:HUB_SHELL,use:{...devices['iPhone SE'],...chromium,viewport:{width:320,height:568}}},
  {name:'phone-390',testMatch:HUB_SHELL,use:{...devices['iPhone 13'],...chromium,viewport:{width:390,height:844}}},
  {name:'phone-414',testMatch:HUB_SHELL,use:{...devices['iPhone 11 Pro Max'],...chromium,viewport:{width:414,height:896}}},
  {name:'phone-landscape',testMatch:HUB_SHELL,use:{...devices['iPhone 13 landscape'],...chromium,viewport:{width:844,height:390}}},
  {name:'ipad-820',testMatch:HUB_SHELL,use:{...devices['iPad Pro 11'],...chromium,viewport:{width:820,height:1180}}},
  {name:'ipad-1180',testMatch:HUB_SHELL,use:{...devices['iPad Pro 11'],...chromium,viewport:{width:1180,height:820}}},
  {name:'laptop-1366',testMatch:HUB_SHELL,use:{...devices['Desktop Chrome'],...chromium,viewport:{width:1366,height:768}}},
 ],
});
