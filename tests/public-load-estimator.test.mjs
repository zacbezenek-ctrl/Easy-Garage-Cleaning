import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimateLoad, PUBLIC_LOAD_PRICING } from '../public-load-estimator.js';
test('unapproved public pricing fails closed at every load size', () => {
  assert.equal(PUBLIC_LOAD_PRICING.tierCents, null);
  assert.equal(PUBLIC_LOAD_PRICING.capacityCubicYards, null);
  for (let step=1;step<=8;step++) { const value=estimateLoad(step); assert.equal(value.cents,null); assert.equal(value.cubicYards,null); assert.equal(value.percent,step*12.5); }
});
test('approved fixtures use exact tier prices rather than invented interpolation', () => {
  const fixture={tierCents:[10000,20000,30000,40000,50000,60000,70000,80000],capacityCubicYards:16};
  assert.deepEqual(estimateLoad(4,fixture),{fraction:.5,percent:50,cents:40000,cubicYards:8,label:'½ truck'});
  assert.equal(estimateLoad(8,fixture).cents,80000);
});
test('invalid tiers cannot produce misleading prices', () => {
  for (const tierCents of [[],[10000],Array(8).fill(-1),Array(8).fill(NaN),[2,1,3,4,5,6,7,8]]) assert.equal(estimateLoad(4,{tierCents}).cents,null);
  for (const step of [0,9,2.5,NaN,'bad']) assert.throws(()=>estimateLoad(step),RangeError);
});
test('public component has accessible progressive enhancement and no private API dependency', () => {
  const html=readFileSync(new URL('../tools/public-site/load-estimator.fragment',import.meta.url),'utf8');
  const js=readFileSync(new URL('../public-load-estimator.js',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public-load-estimator.css',import.meta.url),'utf8');
  assert.match(html,/type="range" min="1" max="8" step="1"/);assert.match(html,/<noscript>/);assert.match(html,/href="\/book"/);assert.match(css,/prefers-reduced-motion:reduce/);
  assert.doesNotMatch(js,/fetch\(|localStorage|pricing-config|1000|api\//);
  for (const name of ['index.html','pricing.html','junk-removal-fort-collins-co.html','fort-collins-junk-removal.html']) {
    const page=readFileSync(new URL('../'+name,import.meta.url),'utf8');
    assert.equal((page.match(/data-load-estimator/g)||[]).length,1,name);
    assert.equal((page.match(/id="load-estimator-heading"/g)||[]).length,1,name);
  }
});
test('mount updates animation, keyboard-facing value, exact prices and presets without sending data', async () => {
  const { mountEstimator } = await import('../public-load-estimator.js');
  const element=()=>({textContent:'',hidden:true,handlers:{},attrs:{},addEventListener(type,fn){this.handlers[type]=fn;},setAttribute(k,v){this.attrs[k]=v;}});
  const nodes=Object.fromEntries(['slider','label','price','detail','controls'].map(k=>[k,element()]));nodes.slider.value='4';
  const button=element();button.dataset={loadStep:'8'};const style={};
  const root={style:{setProperty(k,v){style[k]=v;}},querySelector(selector){return nodes[selector.match(/data-load-(.*)\]/)[1]];},querySelectorAll(){return [button];}};
  mountEstimator(root,{tierCents:Array(8).fill(12345),capacityCubicYards:16,currency:'USD'});
  assert.equal(nodes.controls.hidden,false);assert.equal(style['--load-fill'],'50%');assert.equal(nodes.price.textContent,'$123.45');
  assert.equal(nodes.slider.attrs['aria-valuetext'],'½ truck, 50 percent of truck space');
  button.handlers.click();assert.equal(style['--load-fill'],'100%');assert.equal(nodes.label.textContent,'Full truck · 100%');
  nodes.slider.value='1';nodes.slider.handlers.input();assert.equal(style['--load-fill'],'12.5%');assert.match(nodes.detail.textContent,/2 cubic yards/);
});
