// Every public page (tests/e2e/helpers/public-pages.mjs) on iPhone 375x812, Pixel 7,
// iPad Mini 768x1024 and desktop 1440, plus a 320px phone for horizontal scroll.
import {test,expect,open,touch} from './helpers/test.mjs';
import {PRIMARY_CONTROLS,assertCameraCapture,assertInputKeyboards,assertKnownMissingCamera,assertNoHorizontalScroll,assertTapTargets,tapTargetViolations} from './helpers/mobile-invariants.mjs';
import {publicPages} from './helpers/public-pages.mjs';

const PAGES=publicPages();
// Save reviewable passing-page evidence for each distinct public marketing template.
const VISUAL_REVIEW=new Set(['/index.html','/junk-removal-fort-collins-co.html','/garage-cleaning-fort-collins-co.html','/pricing.html','/book.html','/before-after.html','/about.html','/faq.html','/reviews.html','/service-areas.html','/blog/index.html','/blog/how-much-does-garage-cleanout-cost-fort-collins.html','/projects/index.html','/what-we-take.html','/garage-guard.html','/garage-turnaround-fort-collins-co.html','/privacy-policy.html','/404.html','/garage-cleanouts-loveland-co.html']);
const PHOTO_UPLOADS=['/book.html','/pricing.html'];
// TODO(mobile): known camera gaps. Each page must still load with its image
// upload and library picker; only the missing capture="environment" option is
// tolerated, and adding it fails the test until the entry is deleted here and
// in docs/testing.md.
const KNOWN_NO_CAMERA={
 '/book.html':'TODO(mobile): the walkthrough form photo input is library-only; add a capture="environment" "Take a photo" input beside it.',
 '/pricing.html':'TODO(mobile): the pricing-page walkthrough form photo input is library-only; add a capture="environment" "Take a photo" input beside it.',
};
const NARROW={width:320,height:640};

for(const path of PAGES){
 test.describe(path,()=>{
  test('fits the viewport with no horizontal scroll',async({page},info)=>{
   await open(page,path);await assertNoHorizontalScroll(page);
   if(VISUAL_REVIEW.has(path))await page.screenshot({path:info.outputPath('public-template-full-page.png'),fullPage:true});
  });
  test('fits a 320px phone with no horizontal scroll',async({page},info)=>{
   test.skip(info.project.name!=='iphone-375','The 320px check runs once, in the iPhone project.');
   await page.setViewportSize(NARROW);await open(page,path);await assertNoHorizontalScroll(page);
  });
  test('primary controls are at least 44x44',async({page},info)=>{
   test.skip(!touch(info),'Touch target size applies to touch devices.');
   await open(page,path);await assertTapTargets(page,PRIMARY_CONTROLS,{key:`${info.project.name} ${path}`});
  });
  test('fields raise the right keyboard',async({page})=>{
   await open(page,path);await assertInputKeyboards(page,{key:path});
  });
  if(PHOTO_UPLOADS.includes(path))test('photo upload offers the rear camera and the photo library',async({page},info)=>{
   await open(page,path);
   const gap=KNOWN_NO_CAMERA[path];
   if(gap){info.annotations.push({type:'known camera gap',description:gap});await assertKnownMissingCamera(page,gap);}
   else await assertCameraCapture(page);
  });
 });
}

// The compare slider and its buttons at the top of the touch tablet range (the 1023px
// edge of the styles.css tap block), where the slider used to render 20px tall.
test('before-after compare controls are 44px tall on a 1023px touch tablet',async({page},info)=>{
 test.skip(info.project.name!=='tablet-768','Runs once, in the tablet project.');
 await page.setViewportSize({width:1023,height:1366});await open(page,'/before-after.html');
 const slider=page.locator('.ba-card .controls input[type="range"]').first();
 await expect(slider).toBeVisible();
 expect((await slider.boundingBox()).height).toBeGreaterThanOrEqual(44);
 expect(await tapTargetViolations(page,'.ba-card .controls input, .ba-card .controls button, .ba-card [data-expand]')).toEqual([]);
});

// Truck load planning never creates leads or marketing events in this isolated harness.
test('truck load guide has working keyboard endpoints, presets, reduced motion and responsive screenshots',async({page},info)=>{
 await page.emulateMedia({reducedMotion:'reduce'});
 await open(page,'/index.html');
 await page.screenshot({path:info.outputPath('public-home-after.png')});
 const root=page.locator('[data-load-estimator]');
 const slider=root.getByRole('slider',{name:'Choose your estimated load size'});
 await slider.scrollIntoViewIfNeeded();
 await slider.press('Home');await expect(slider).toHaveValue('1');
 await expect(slider).toHaveAttribute('aria-valuetext','⅛ truck, 12.5 percent of truck space');
 await slider.press('End');await expect(slider).toHaveValue('8');
 await expect(slider).toHaveAttribute('aria-valuetext','Full truck, 100 percent of truck space');
 await root.getByRole('button',{name:'½ truck',exact:true}).click();await expect(slider).toHaveValue('4');
 await expect(root.locator('[data-load-price]')).toHaveText('Get an on-site quote');
 expect(await root.locator('.load-fill').evaluate(el=>getComputedStyle(el).transitionDuration)).toBe('0s');
 await assertNoHorizontalScroll(page);
 expect(await page.evaluate(()=>typeof window.fbq)).toBe('undefined');
 await root.screenshot({path:info.outputPath('truck-load-guide-after.png')});
});
