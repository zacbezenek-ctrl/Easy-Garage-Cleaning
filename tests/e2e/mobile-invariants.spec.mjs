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

test('an inline link passes by its padding only when later text does not cover the padding',async({page:tab})=>{
 const copy=link=>`<div style="width:300px;margin:60px 0;font:14px/1.5 system-ui">Text photos of the garage and the driveway to ${link} before the walkthrough so the crew can plan the truck, the dump run and the donation drop-off.</div>`;
 await tab.setContent(page(copy('<a id="covered" href="sms:+19705550100" style="padding:16px 0">(970) 555-0100</a>')+copy('<a id="lifted" href="sms:+19705550101" style="padding:16px 0;position:relative">(970) 555-0101</a>')+copy('<a id="bare" href="sms:+19705550102">(970) 555-0102</a>')));
 const found=await tapTargetViolations(tab);
 expect(found.map(item=>item.id).sort()).toEqual(['a#bare "(970) 555-0102"','a#covered "(970) 555-0100"']);
 expect(found.find(item=>item.id.startsWith('a#covered')).note).toBe('padding does not take taps');
 expect(found.find(item=>item.id.startsWith('a#bare')).note).toBeUndefined();
 expect(await tab.evaluate(()=>window.scrollY),'the probe restores the scroll position').toBe(0);
});

test('a link whose words sit under a neighbour\'s padding is reported, even an exempt link in running text',async({page:tab})=>{
 const lines=(prefix,upper,lower)=>`<p style="width:320px;margin:60px 0;font:15px/1.65 system-ui">We run <a id="${prefix}1" href="/loveland" ${upper}>junk removal in Loveland</a>,<br>and <a id="${prefix}2" href="/windsor" ${lower}>junk removal in Windsor</a> too.</p>`;
 const lifted='style="position:relative;padding:16px 0"';
 await tab.setContent(page(lines('both',lifted,lifted)+lines('lower','',lifted)+lines('none','','')+
  '<p style="position:absolute;top:740px;left:0;margin:0">Or <a id="barred" href="/call">call the office</a> today.</p><nav style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#fff"><a href="tel:+19705550100" style="display:block;height:100px">Call</a></nav>'));
 const found=await tapTargetViolations(tab);
 expect(found.map(item=>item.id).sort()).toEqual(['a#both1 "junk removal in Loveland"','a#lower1 "junk removal in Loveland"']);
 expect(found.find(item=>item.id.startsWith('a#both1')).note).toBe('covered by a#both2 "junk removal in Windsor"');
 expect(found.find(item=>item.id.startsWith('a#lower1')).note).toBe('covered by a#lower2 "junk removal in Windsor"');
 expect(await tab.evaluate(()=>window.scrollY),'the probe restores the scroll position').toBe(0);
});

test('an inline control is measured on every line it wraps onto, not on its combined box',async({page:tab})=>{
 await tab.setContent(page('<div style="width:130px;font:16px/2 system-ui">Call <a id="wrapped" href="tel:+19705550103">(970) 555-0103 today</a></div><div style="font:16px/2 system-ui">Call <a id="boxed" href="tel:+19705550104" style="display:inline-flex;align-items:center;min-height:44px">(970) 555-0104</a></div>'));
 const combined=await tab.locator('#wrapped').evaluate(link=>({lines:link.getClientRects().length,height:link.getBoundingClientRect().height}));
 expect(combined.lines).toBe(2);expect(combined.height,'the combined box alone would pass').toBeGreaterThanOrEqual(44);
 const found=await tapTargetViolations(tab);
 expect(found.map(item=>item.id)).toEqual(['a#wrapped "(970) 555-0103 today"']);
 expect(found[0].note).toBe('a line of it is under 44px');expect(found[0].height).toBeLessThan(44);
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
