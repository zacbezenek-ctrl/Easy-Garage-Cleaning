/** Period revenue display must not turn confirmed, undated outcomes into $0. */
export type RevenueDisplayInput={valueCents?:number|null;knownSubtotalCents?:number|null;unknownValueCount?:number;unknownOccurrenceCount?:number;missingValue?:unknown[];unknownOccurrenceEvents?:unknown[];coverageIncomplete?:boolean;qualification?:string};
const amount=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value);
const count=(value:unknown,fallback:number)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:fallback;
const usd=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
export function revenueDisplay(input:RevenueDisplayInput){
 const unknownDates=count(input.unknownOccurrenceCount,input.unknownOccurrenceEvents?.length??0),unknownValues=count(input.unknownValueCount,input.missingValue?.length??0);
 const complete=amount(input.valueCents)&&!input.coverageIncomplete&&!unknownDates&&!unknownValues;
 const subtotal=amount(input.knownSubtotalCents)?input.knownSubtotalCents:complete?input.valueCents!:null;
 return{complete,total:complete?usd(input.valueCents!):'Total unavailable',subtotal:subtotal===null?'Not available':usd(subtotal),unknownDates,unknownValues,
  qualification:input.qualification||(complete?'Verified dated outcomes in this period.':'The verified dated subtotal is not a complete period total.')};
}
