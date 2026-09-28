// Prints synthetic money documents plus their response headers as JSON for
// tests/browser/test_money_document_ui.py. Time is fixed; nothing reads the clock.
import { moneyDocumentHeaders, renderMoneyDocument } from '../../functions/_lib/money-document.js';

const NOW = '2026-09-22T18:00:00.000Z';
const long = 'Synthetic-Customer-With-An-Extremely-Long-Unbroken-Name-That-Must-Wrap-On-A-Phone';
const job = {
  id: 'synthetic-browser-000301', type: 'job', customer: long, address: '12345 Synthetic Extraordinarily-Long-Street-Name Boulevard, Fort Collins, Colorado 80525',
  phone: '970-555-0103', email: 'a-very-long-synthetic-mailbox-name-for-wrapping@example.invalid', serviceType: 'Complete garage transformation with organization',
  estimate: { number: 'EST-000301', status: 'approved', amount: 999999.99, depositRequired: 499999.99, termsVersion: '2026-09', revision: 3, validUntil: '2026-10-15', createdAt: '2026-09-18T15:00:00.000Z', scope: `Synthetic scope ${'with-a-long-unbroken-token-'.repeat(6)}`,
    lineItems: [
      { id: 'main', kind: 'service', name: `Synthetic ${'Unbroken-Line-Item-Name-'.repeat(5)}`, description: 'Synthetic description of the bundled service with enough words to wrap across several lines on a small phone screen.', quantity: 1, unitCents: 99900000, totalCents: 99900000 },
      { id: 'shelves', kind: 'product', name: 'Synthetic shelving', description: '', quantity: 12.5, unitCents: 8000, totalCents: 100000, optional: true, selected: true },
      { id: 'epoxy', kind: 'service', name: 'Synthetic epoxy floor', description: '', quantity: 1, unitCents: 250000, totalCents: 250000, optional: true, selected: false },
      { id: 'discount', kind: 'discount', name: 'Synthetic rounding credit', description: '', quantity: 1, unitCents: -1, totalCents: -1 },
    ] },
  customerApproval: { status: 'approved', approvedBy: long, approvedAt: '2026-09-19T16:00:00.000Z', source: 'customer_portal' },
  payment: { amount: 500049.99, verified: true, receiptUrl: 'https://pay.stripe.com/receipts/synthetic-browser', stripeSessions: [
    { sessionId: 'cs_test_browser_deposit', paymentIntentId: 'pi_browser_deposit', amount: 499999.99, purpose: 'deposit', verifiedAt: '2026-09-19T16:05:00.000Z' },
    { sessionId: 'cs_test_browser_tip', paymentIntentId: 'pi_browser_tip', amount: 50, purpose: 'tip', verifiedAt: '2026-09-21T22:00:00.000Z' },
  ] },
  invoice: { number: 'INV-000301', status: 'issued', issuedAt: '2026-09-21T23:00:00.000Z', dueDate: '2026-09-28', customerReference: `PO-${'9'.repeat(60)}` },
  status: 'completed', completedAt: '2026-09-21T21:00:00.000Z',
};
// The portal checkout still counts a tip as paid, so a document offers "Pay" only
// without one: the estimate and invoice show the pay button, the receipt the tip.
const untipped = { ...job, payment: { ...job.payment, amount: 499999.99, stripeSessions: job.payment.stripeSessions.slice(0, 1) } };
const documents = Object.fromEntries(['estimate', 'invoice', 'receipt'].map(kind => [kind, renderMoneyDocument(kind === 'receipt' ? job : untipped, { kind, now: NOW, payUrl: '/customer-portal#pay' })]));
process.stdout.write(JSON.stringify({ headers: moneyDocumentHeaders(), documents }));
