// The invariants are the contract, so prove each one catches a real violation.
import {test,expect} from './helpers/test.mjs';
import {assertCameraCapture,assertKnownMissingCamera,assertNoHorizontalScroll,keyboardViolations,tapTargetViolations} from './helpers/mobile-invariants.mjs';

const page=(body,style='')=>`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:16px system-ui}${style}</style></head><body>${body}</body></html>`;
test.beforeEach(({},info)=>{test.skip(info.project.name!=='iphone-375','Helper self-test runs once, on the 375px phone.');});

test('overflow is caught even when body clips it with overflow-x:hidden',async({page:tab})=>{
 await tab.setContent(page('<main><div id="wide" style="width:520px;height:20px">wide</div></main>'));
 await expect(assertNoHorizontalScroll(tab)).rejects.toThrow(/Horizontal scroll at 375px.*div#wide/s);
 await tab.setContent(page('<main><div id="wide" style="width:520px;height:20px">wide</div></main>','body{overflow-x:hidden}'));
 await expect(assertNoHorizontalScroll(tab)).rejects.toThrow(/Horizontal scroll at 375px/);
 await tab.setContent(page('<main><p style="overflow-wrap:anywhere">fits</p><div style="width:376px;height:4px"></div></main>'));
 await assertNoHorizontalScroll(tab);
});

test('small visible controls are reported; label boxes, hidden, off-screen and inline links are not',async({page:tab})=>{
 await tab.setContent(page(`
  <button id="small" style="height:30px">Small</button>
  <button id="big" style="min-height:44px;min-width:44px">Big</button>
  <label style="display:block;padding:14px 0"><input type="checkbox" id="covered"> Label makes this 44px tall</label>
  <input type="checkbox" id="bare" style="width:20px;height:20px">
  <button id="hidden" style="display:none">Hidden</button>
  <a class="skip-btn" style="position:absolute;left:-9999px" href="#main">Skip</a>
  <div aria-hidden="true"><button>Decorative</button></div>
  <p>Copy with an <a href="/faq">inline link</a>.</p>
  <a class="btn-primary" href="/book" style="display:inline-block;padding:4px">Book</a>
  <input name="botcheck" tabindex="-1" style="width:1px;height:1px">`));
 const found=(await tapTargetViolations(tab)).map(item=>item.id);
 expect(found.sort()).toEqual(['a "Book"','button#small "Small"','input#bare[type=checkbox] ""'].sort());
});

test('every link is a tap target unless it is an inline link in the running text of a <p> or <li>',async({page:tab})=>{
 await tab.setContent(page(`
  <p>Read the <a href="/faq">FAQ</a> or <strong>see <a href="/pricing">pricing</a></strong> first.</p>
  <ul><li>Questions? <a href="/contact">Contact the office</a> any weekday.</li></ul>
  <footer>
   <p>Call <a href="tel:+19705550100">(970) 555-0100</a> today.</p>
   <p>Write to <a href="mailto:synthetic@example.invalid">synthetic@example.invalid</a> anytime.</p>
   <ul><li><a href="/garage-cleanout">Garage cleanout</a></li><li><a href="/estate">Estate cleanout</a> · <a href="/move">Move-out</a></li></ul>
   <p><a href="/walkthrough">Request walkthrough →</a></p>
   <p>Also: <a href="/block" style="display:inline-block">Styled chip</a> for a block link.</p>
   <div><a href="/div-link">Link in a div</a></div>
   <span role="link" tabindex="0">ARIA link</span>
   <nav><a href="/about">About</a></nav>
  </footer>`));
 const found=(await tapTargetViolations(tab)).map(item=>item.id);
 expect(found.sort()).toEqual(['a "(970) 555-0100"','a "synthetic@example.invalid"','a "Garage cleanout"','a "Estate cleanout"','a "Move-out"','a "Request walkthrough →"','a "Styled chip"','a "Link in a div"','span "ARIA link"','a "About"'].sort());
});

test('phone, email and money fields need the matching keyboard; search boxes are exempt',async({page:tab})=>{
 await tab.setContent(page(`
  <label>Mobile phone <input id="p1" name="phone"></label>
  <label>Phone <input id="p2" type="tel" autocomplete="tel"></label>
  <label>Phone <input id="p3" inputmode="tel"></label>
  <label>Customer phone <input id="p4" type="tel" autocomplete="off"></label>
  <label>Email <input id="e1" type="email"></label>
  <label>Email <input id="e2" type="email" autocomplete="email"></label>
  <label>Deposit amount <input id="m1"></label>
  <label>Deposit amount <input id="m2" inputmode="decimal"></label>
  <label>ZIP <input id="z1"></label>
  <label>Search by name or phone <input id="s1"></label>
  <input id="s2" type="search" placeholder="Phone or email">
  <input type="hidden" name="phone">`));
 expect((await keyboardViolations(tab)).map(item=>item.id).sort()).toEqual(['input#e1 needs email','input#m1 needs decimal','input#p1[name=phone] needs tel','input#p3 needs tel','input#z1 needs postal-code'].sort());
});

test('photo uploads need both a rear-camera capture and a library picker',async({page:tab})=>{
 await tab.setContent(page('<label>Library <input type="file" accept="image/*" multiple></label>'));
 await expect(assertCameraCapture(tab)).rejects.toThrow(/capture="environment" camera option/);
 await tab.setContent(page('<label>Camera <input type="file" accept="image/*" capture="environment"></label>'));
 await expect(assertCameraCapture(tab)).rejects.toThrow(/photo-library picker/);
 await tab.setContent(page('<label>Document <input type="file" accept="application/pdf"></label>'));
 await expect(assertCameraCapture(tab)).rejects.toThrow(/an image upload control/);
 await tab.setContent(page('<label>Camera <input type="file" accept="image/*" capture="environment"></label><label>Library <input type="file" accept="image/*" multiple></label>'));
 expect((await assertCameraCapture(tab)).length).toBe(2);
});

test('a known camera gap passes only when the page has its uploads and lacks exactly the capture option',async({page:tab})=>{
 const reason='synthetic known gap';
 await tab.setContent(page('<label>Library <input type="file" accept="image/*" multiple></label>'));
 expect((await assertKnownMissingCamera(tab,reason)).length).toBe(1);
 await tab.setContent(page('<label>Camera <input type="file" accept="image/*" capture="environment"></label><label>Library <input type="file" accept="image/*"></label>'));
 await expect(assertKnownMissingCamera(tab,reason)).rejects.toThrow(/Known camera gap is fixed.*synthetic known gap/s);
 await tab.setContent(page('<p>The upload form failed to render.</p>'));
 await expect(assertKnownMissingCamera(tab,reason)).rejects.toThrow(/an image upload control/);
 await tab.setContent(page('<label>Camera only <input type="file" accept="image/*" capture="user"></label>'));
 await expect(assertKnownMissingCamera(tab,reason)).rejects.toThrow(/photo-library picker/);
});
