import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWebsiteInquiry, WEBSITE_INQUIRY_SOURCE as source } from '../functions/_lib/native-website-inquiry.js';

test('native inquiry reads only verified fields and preserves customer-reported text', () => {
  const contact={source,customFields:[{id:'QHj6fV2cJQXHL2PNOXr1',value:' 2 car '},{id:'LFY6ICXlG2RKhlg0vgTT',value:'Organization'},{id:'private',value:'PRIVATE-MARGIN'}]};
  assert.deepEqual(nativeWebsiteInquiry(contact),{source,garageSize:'2 car',service:'Organization'});
  assert.equal(nativeWebsiteInquiry({...contact,source:'Hiring'}),null);
  assert.deepEqual(nativeWebsiteInquiry({source,customFields:[{key:'egc_website_garage_size',fieldValue:'1 car'}]}),{source,garageSize:'1 car',service:''});
});
test('missing, malformed and conflicting fields stay unfilled instead of guessing', () => {
  for(const customFields of [null,[],[{id:'QHj6fV2cJQXHL2PNOXr1',value:{size:'large'}}],[{id:'QHj6fV2cJQXHL2PNOXr1',value:'x'.repeat(201)}],[{id:'QHj6fV2cJQXHL2PNOXr1',value:'1 car'},{id:'QHj6fV2cJQXHL2PNOXr1',value:'2 car'}]])assert.deepEqual(nativeWebsiteInquiry({source,customFields}),{source,garageSize:'',service:''});
});
