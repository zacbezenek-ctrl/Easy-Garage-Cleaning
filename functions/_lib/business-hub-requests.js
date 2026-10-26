/* Business requests become unpriced, unscheduled Hub work only after explicit manager review.
   No schedule, payment, provider write, or message is created here. */
import { bounded, digest, fail, isId, requireJobId, text } from './business-hub-core.js';
import { operationReceipt } from './business-hub-scope.js';
import { customerIdentityFields } from './customer-identity.js';
import { projectDimensionPatch, resolveDimensions, visitDimensionFacts } from './funnel-dimensions.js';

const OPEN = new Set(['submitted', 'reviewing', 'awaiting_customer']);
function references(input) {
  if (!isId(input.serviceRequestId)) throw fail(400, 'Choose a saved business service request.');
  return { serviceRequestId: input.serviceRequestId, customerId: requireJobId(input.customerId) };
}
function requestOf(ctx, id, h) {
  const request = (ctx.account.requests || []).find(row => row.id === id);
  if (!request) throw fail(404, 'Service request not found.');
  const property = h.property(ctx, request.propertyId);
  return { request, property };
}
async function reviewed(ctx, input, h) {
  const ids = references(input), { request, property } = requestOf(ctx, ids.serviceRequestId, h);
  if (input.accountRevision !== ctx.account._version) throw fail(409, 'This account changed. Refresh and review the saved request again.');
  if (request.jobId || !OPEN.has(request.status)) throw fail(409, 'This request is closed or already linked to a project.');
  const customer = await h.store.read('customers', ids.customerId);
  if (!customer || customer.id !== ids.customerId || typeof customer._version !== 'string' || !customer._version || customer.recordType || customer.deleted === true ||
      ['deleted', 'merged', 'inactive'].includes(customer.status) || customer.mergedInto ||
      customer.businessAccountId && customer.businessAccountId !== ctx.account.id) throw fail(409, 'Select an available customer authorized for this company.');
  const name = text(customer.name || [customer.firstName, customer.lastName].filter(Boolean).join(' '), 200, true);
  const facts = {
    accountId: ctx.account.id,
    request: { id: request.id, propertyId: request.propertyId, service: request.service, scope: request.scope, payer: request.payer,
      purchaseOrder: request.purchaseOrder || '', onsiteContact: request.onsiteContact || '', preferredDate: request.preferredDate || '' },
    property: { id: property.id, name: property.name, address: property.address, access: property.access || '', contact: property.contact || '' },
    customer: { id: customer.id, name, phone: customer.phone || '', email: customer.email || '', highlevelContactId: customer.highlevelContactId || '', revision: customer._version },
  };
  return { ...ids, request, property, customer, facts, token: await digest(JSON.stringify(facts)) };
}
async function preview(ctx, input, h) {
  h.requireJobCreator(ctx);
  const info = await reviewed(ctx, input, h);
  const { revision, highlevelContactId, ...customer } = info.facts.customer;
  return h.response(200, { ok: true, previewToken: info.token, accountRevision: ctx.account._version, customer,
    request: info.facts.request, property: info.facts.property, outcome: 'Unpriced, unscheduled job; no messages or appointment.' });
}
async function linked(ctx, request, customerId, h) {
  const job = await h.store.read('jobs', request.jobId);
  const link = (ctx.account.projects || []).find(row => row.jobId === request.jobId && row.active !== false);
  const project = job?.projectId && await h.store.read('projects', job.projectId);
  if (!job || job.customerId !== customerId || job.businessAccountId !== ctx.account.id || job.businessPropertyId !== request.propertyId ||
      !link || link.propertyId !== request.propertyId || !project || project.customerId !== customerId || project.businessAccountId !== ctx.account.id) {
    throw fail(409, 'The saved conversion needs manager review. No new job was created.');
  }
  return { jobId: job.id, projectId: project.id };
}
async function convert(ctx, input, h) {
  h.requireJobCreator(ctx);
  const { serviceRequestId, customerId } = references(input), { request } = requestOf(ctx, serviceRequestId, h);
  if (!isId(input.requestId) || typeof input.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.previewToken)) throw fail(400, 'Review this conversion before confirming it.');
  if (input.sharingAuthorized !== true) throw fail(400, 'Confirm that this company is authorized for the selected customer, property, scope and billing.');
  const at = new Date(h.now()).toISOString();
  const receipt = await operationReceipt(h.store, ctx, 'convert_business_request', input.requestId,
    { serviceRequestId, customerId, previewToken: input.previewToken }, at);
  if (request.jobId) {
    if (request.conversionPreviewToken !== input.previewToken) throw fail(409, 'This request already has a project. Open that project instead.');
    const result = await linked(ctx, request, customerId, h);
    if (!receipt.duplicate) await h.store.commit(receipt.writes);
    return h.response(200, { ok: true, duplicate: true, ...result });
  }
  if (receipt.duplicate) throw fail(409, 'The saved conversion needs manager review. No new job was created.');
  const info = await reviewed(ctx, input, h);
  if (info.token !== input.previewToken) throw fail(409, 'The selected customer or request changed. Review the conversion again.');
  bounded(ctx.account, 'projects');
  const suffix = (await digest(`${ctx.account.id}:${serviceRequestId}`)).slice(0, 32), jobId = `business_request_${suffix}`, projectId = `project_${jobId}`;
  const job = {
    id: jobId, type: 'job', customerId, customer: info.facts.customer.name, phone: info.customer.phone || '', email: info.customer.email || '',
    ...customerIdentityFields(info.customer), highlevelContactId: info.customer.highlevelContactId || '',
    address: info.property.address, propertyId: info.property.id, serviceType: info.request.service,
    title: info.request.service, jobInstructions: info.request.scope, accessInstructions: info.property.access || '',
    customerInstructions: info.request.onsiteContact || info.property.contact || '',
    operationalScope: { text: info.request.scope, updatedAt: at, updatedBy: ctx.profile.user, reason: 'Reviewed business service request', approvalKind: 'staff_operational_instructions' },
    date: '', time: '', endDate: '', endTime: '', assignedCrew: [], assignedTo: '', crewLead: null, crewId: null, vehicleId: null,
    status: 'unscheduled', pipelineStatus: 'unscheduled', estimate: { status: 'draft' }, notify: false, syncStatus: 'not_needed',
    scheduleSource: 'egc_hub', needsDispatchReview: true, projectId, source: 'business_request',
    businessAccountId: ctx.account.id, businessPropertyId: info.property.id, businessSharingApprovedBy: ctx.profile.user, businessSharingApprovedAt: at,
    businessRequest: { ...info.facts.request, accountId: ctx.account.id, submittedAt: info.request.createdAt || '', convertedAt: at },
    createdAt: at, updatedAt: at, createdBy: ctx.profile.user,
  };
  const project = { id: projectId, customerId, sourceRecordId: jobId, businessAccountId: ctx.account.id, businessPropertyId: info.property.id,
    authority: 'employee_hub', createdAt: at, updatedAt: at, createdBy: ctx.profile.user, highlevelContactId: job.highlevelContactId,
    ...projectDimensionPatch(null, resolveDimensions(visitDimensionFacts(job)), { actor: ctx.profile.user, now: at }) };
  ctx.account.projects.push({ jobId, propertyId: info.property.id, active: true, sharedBy: ctx.profile.user, sharedAt: at });
  const beforeStatus = request.status;
  Object.assign(request, { jobId, status: 'project_linked', updatedAt: at, convertedAt: at, conversionPreviewToken: input.previewToken });
  await h.save(ctx, 'convert_business_request', [
    { collection: 'jobs', id: jobId, data: job }, { collection: 'projects', id: projectId, data: project },
    // Pin the selected customer identity without changing it; no guessed identity or attribution rewrite.
    { collection: 'customers', id: customerId, data: { id: customerId }, patch: true, version: info.customer._version },
    ...receipt.writes,
  ], { hub: 'business.request_converted', requestId: input.requestId, before: { requestId: serviceRequestId, status: beforeStatus }, after: { requestId: serviceRequestId, jobId, projectId, status: 'unscheduled' } });
  return h.response(201, { ok: true, jobId, projectId, status: 'unscheduled', priceApproved: false, messagesSent: false });
}
export const actions = { preview_business_request_conversion: preview, convert_business_request: convert };
export const decorate = [(view, ctx) => {
  if (ctx.staff && ctx.manager) view.businessRequestRevision = ctx.account._version;
  if (!ctx.staff) view.requests = view.requests.map(({ conversionPreviewToken, ...request }) => request);
  return view;
}];
