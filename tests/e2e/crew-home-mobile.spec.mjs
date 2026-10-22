// LIVE-JOB-LINKS: the crew home at 390px for a manager. The next job's main button opens the live job page
// (/crew/job.html, saved through /api/field-jobs) and the old pre-job playbook stays beside it as a reference link;
// a crew member sees only the live page. Synthetic data from helpers/hub-fixture.mjs, the clock at NOW.
import {test,expect,open} from './helpers/test.mjs';
import {assertNoHorizontalScroll} from './helpers/mobile-invariants.mjs';
import {CREW,JOBS,MANAGER,hubFixtures} from './helpers/hub-fixture.mjs';

test.use({viewport:{width:390,height:844}});

async function home(page,profile){
 await hubFixtures(page,{profile});
 // The fixture job is the crew member's; here it is also on the manager's list (a later route wins in Playwright).
 if(profile===MANAGER)await page.route(url=>url.hostname==='127.0.0.1'&&url.pathname==='/api/crew-jobs',route=>route.fulfill({status:200,contentType:'application/json',
  body:JSON.stringify({ok:true,jobs:JOBS.map(job=>job.id==='job-today'?{...job,assignedCrew:[...job.assignedCrew,'zacb']}:job)})}));
 await open(page,'/crew/index.html');
 await page.locator('#next-work a.primary').waitFor();
}

test('manager: the next job opens the live job page, the playbook stays one tap away, and the page fits 390px',async({page})=>{
 await home(page,MANAGER);
 await expect(page.locator('#next-work a.primary')).toHaveAttribute('href','/crew/job.html?jobId=job-today');
 const playbook=page.locator('#next-work a',{hasText:'Playbook (reference)'});
 await expect(playbook).toHaveAttribute('href','/crew/prejob?jobId=job-today');
 await expect(playbook).toBeVisible();
 await expect(page.locator('#assigned-jobs a.job-row[href*="prejob"], #assigned-jobs a.job-row[href*="postjob"]')).toHaveCount(0);
 await expect(page.locator('#assigned-jobs a.job-row[href="/crew/job.html?jobId=job-today"]')).toHaveCount(1);
 await expect(page.locator('#prejob-tool')).toHaveAttribute('href','/crew/prejob');
 await expect(page.locator('#closeout-tool')).toHaveAttribute('href','/crew/postjob');
 await expect(page.locator('#prejob-tool h2')).toHaveText('Pre-job (reference)');
 await expect(page.locator('#closeout-tool h2')).toHaveText('Closeout (reference)');
 await expect(page.locator('.crew-utility a',{hasText:'Pre-job (reference)'})).toHaveCount(1);
 await assertNoHorizontalScroll(page);
});

test('crew: the next job opens the live job page with no playbook link',async({page})=>{
 await home(page,CREW);
 await expect(page.locator('#next-work a.primary')).toHaveAttribute('href','/crew/job.html?jobId=job-today');
 await expect(page.locator('#next-work a',{hasText:'Playbook'})).toHaveCount(0);
 await expect(page.locator('#prejob-tool h2')).toHaveText('Pre-job');
 await expect(page.locator('#prejob-tool')).toHaveAttribute('href','/crew/job');
 await assertNoHorizontalScroll(page);
});
