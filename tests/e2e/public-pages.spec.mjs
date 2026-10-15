// Every public page (tests/e2e/helpers/public-pages.mjs) on iPhone 375x812, Pixel 7,
// iPad Mini 768x1024 and desktop 1440, plus a 320px phone for horizontal scroll.
import {test,expect,open,touch} from './helpers/test.mjs';
import {PRIMARY_CONTROLS,assertCameraCapture,assertInputKeyboards,assertKnownMissingCamera,assertNoHorizontalScroll,assertTapTargets,tapTargetViolations} from './helpers/mobile-invariants.mjs';
import {publicPages} from './helpers/public-pages.mjs';

const PAGES=publicPages();
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

test('curbside quote action reaches its form by keyboard and closes the mobile drawer',async({page})=>{
 await open(page,'/flat-rate-junk-removal-fort-collins-co.html');
 const original=page.url().split('#')[0],target=page.locator('#quote');
 const desktop=page.locator('.nav-cta');
 if(await desktop.isVisible()){
  await desktop.focus();await page.keyboard.press('Enter');
 }else{
  await page.locator('.nav-toggle').click();
  const action=page.locator('#nav-drawer .drawer-cta');
  await action.focus();await page.keyboard.press('Enter');
  await expect(page.locator('.nav-toggle')).toHaveAttribute('aria-expanded','false');
  await expect(page.locator('#nav-drawer')).toHaveAttribute('aria-hidden','true');
  expect(await page.locator('#nav-drawer').evaluate(el=>el.inert)).toBe(true);
 }
 await expect(page).toHaveURL(original+'#quote');
 await expect(target).toBeFocused();
 await expect(target.locator('form')).toBeVisible();
 await expect.poll(async()=>{
  const box=await target.boundingBox();
  return box!==null&&box.y>=0&&box.y<page.viewportSize().height;
 }).toBe(true);
 await page.keyboard.press('Tab');
 expect(await target.evaluate(el=>el.contains(document.activeElement))).toBe(true);
});

for(const path of PAGES){
 test.describe(path,()=>{
  test('fits the viewport with no horizontal scroll',async({page})=>{
   await open(page,path);await assertNoHorizontalScroll(page);
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
