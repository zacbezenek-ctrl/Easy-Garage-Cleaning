// Public marketing pages on iPhone 375x812, Pixel 7 and desktop 1440.
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {test,open,touch} from './helpers/test.mjs';
import {PRIMARY_CONTROLS,assertCameraCapture,assertInputKeyboards,assertKnownMissingCamera,assertNoHorizontalScroll,assertTapTargets} from './helpers/mobile-invariants.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const SERVICE_PAGES=readdirSync(root).filter(name=>/-fort-collins-co\.html$/.test(name)).sort().map(name=>'/'+name);
const PAGES=['/index.html','/book.html','/pricing.html','/before-after.html','/garage-guard.html',...SERVICE_PAGES];
const PHOTO_UPLOADS=['/book.html','/pricing.html'];
// TODO(mobile): known camera gaps. Each page must still load with its image
// upload and library picker; only the missing capture="environment" option is
// tolerated, and adding it fails the test until the entry is deleted here and
// in docs/testing.md.
const KNOWN_NO_CAMERA={
 '/book.html':'TODO(mobile): the walkthrough form photo input is library-only; add a capture="environment" "Take a photo" input beside it.',
 '/pricing.html':'TODO(mobile): the pricing-page walkthrough form photo input is library-only; add a capture="environment" "Take a photo" input beside it.',
};

for(const path of PAGES){
 test.describe(path,()=>{
  test('fits the viewport with no horizontal scroll',async({page})=>{
   await open(page,path);await assertNoHorizontalScroll(page);
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
