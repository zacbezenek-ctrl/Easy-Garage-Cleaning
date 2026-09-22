import test from 'node:test';
import assert from 'node:assert/strict';
import {revenueDisplay} from '../egc-platform/apps/portal/lib/revenue-display.ts';

test('undated confirmed outcomes display a dated subtotal without asserting a zero total',()=>{
 const result=revenueDisplay({valueCents:null,knownSubtotalCents:0,unknownOccurrenceCount:1,unknownValueCount:1,coverageIncomplete:true,qualification:'Confirmed outcome has no verified occurrence date.'});
 assert.equal(result.total,'Total unavailable');assert.equal(result.subtotal,'$0.00');assert.equal(result.complete,false);assert.equal(result.unknownDates,1);assert.equal(result.unknownValues,1);assert.equal(result.qualification,'Confirmed outcome has no verified occurrence date.');
});
test('known dated receipts remain visible when other payment history is incomplete',()=>{
 const result=revenueDisplay({valueCents:null,knownSubtotalCents:13900,unknownOccurrenceCount:0,unknownValueCount:0,coverageIncomplete:true});assert.equal(result.total,'Total unavailable');assert.equal(result.subtotal,'$139.00');assert.equal(result.unknownDates,0);assert.equal(result.unknownValues,0);
});
test('unverified amounts and legacy missing-value evidence cannot be mislabeled as a full total',()=>{
 const result=revenueDisplay({valueCents:0,knownSubtotalCents:0,missingValue:['sale-without-amount']});assert.equal(result.total,'Total unavailable');assert.equal(result.unknownValues,1);
 const unavailable=revenueDisplay({valueCents:null});assert.equal(unavailable.subtotal,'Not available');assert.equal(unavailable.total,'Total unavailable');
});
test('a completely verified zero or positive total remains a real total',()=>{
 assert.deepEqual(revenueDisplay({valueCents:0,knownSubtotalCents:0,unknownOccurrenceCount:0,unknownValueCount:0}).total,'$0.00');
 const verified=revenueDisplay({valueCents:15050,knownSubtotalCents:15050});assert.equal(verified.complete,true);assert.equal(verified.total,'$150.50');
});
