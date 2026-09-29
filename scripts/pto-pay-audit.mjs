/** PTO pay audit (P1-06). READ ONLY: decrypts the Employee Hub time-off requests and
 * prints the approved time off to review before the first payroll export after the
 * request workflow ships. It has no write mode. Each correction is made in the Hub
 * (Requests > Edit pay), which records it as an audited manager decision.
 *
 * It lists two kinds of approved time off:
 *  - unboundPayFields: pay fields (paid, hoursPerDay, paidDates, paidHoursPerDay,
 *    paidWeekends) that no workflow approve or amend decision set. Before the workflow a
 *    crew member could write any field into a request, and a manager approved it in the
 *    browser without seeing pay. Payroll now ignores paid/hoursPerDay/paidDates on such a
 *    request and pays only a manager-set paidHoursPerDay; `payroll` shows what it pays.
 *  - blocksPayroll: pay terms or dates payroll cannot read. They hold that week's payroll
 *    CSV in review (needs_review cannot be acknowledged) until a manager changes the pay.
 *
 *   node scripts/pto-pay-audit.mjs                     # print the report
 *   node scripts/pto-pay-audit.mjs --report out.json   # also save it (mode 600)
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON and the vault key the Pages Functions use
 * (EMPLOYEE_HUB_DATA_SECRET, or the configured legacy key source). The report holds
 * request IDs, employee usernames, dates, pay field names and paid hours; no reasons
 * or notes. */
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {employeeVaultSecret} from '../functions/_lib/employee-vault-key.js';
import {readCollection} from '../functions/_lib/employee-vault.js';
import {assignmentKey} from '../functions/_lib/job-assignment.js';
import {ptoPaidDays,ptoWorkflowApproved} from '../functions/_lib/pto-pay.js';

export const PAY_FIELDS=['paid','hoursPerDay','paidDates','paidHoursPerDay','paidWeekends'];
const ENV=['FIREBASE_SERVICE_ACCOUNT_JSON','EMPLOYEE_HUB_DATA_SECRET','EMPLOYEE_HUB_LEGACY_KEY_SOURCE','HIGHLEVEL_API_KEY','HUB_SESSION_SECRET','EGC_EMPLOYEE_VAULT_QUERY'];
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const payable=hours=>typeof hours==='number'&&Number.isFinite(hours)&&hours>0&&hours<=24;
const fail=(code,message)=>Object.assign(new Error(message),{code:'pto_pay_audit_'+code});
const byId=(a,b)=>a.id.localeCompare(b.id);

/** Pure report from one complete list of decrypted requests. */
export function planPtoPayAudit(requests,now) {
  if(!Array.isArray(requests))throw fail('input_invalid','A complete request list is required.');
  const report={mode:'read_only',generatedAt:now,scanned:requests.length,approvedTimeOff:0,workflowApproved:0,unboundPayFields:[],blocksPayroll:[]};
  for(const request of requests) {
    if(!record(request)||request.type!=='time_off'||request.status!=='approved')continue;
    report.approvedTimeOff++;
    const bound=ptoWorkflowApproved(request),pay=ptoPaidDays(request);
    if(bound)report.workflowApproved++;
    const row={id:String(request.id||''),employee:assignmentKey(request.employee)||String(request.employee||''),startDate:String(request.startDate||''),endDate:String(request.endDate||request.startDate||''),...(request.endedEarlyFrom?{endedEarlyFrom:String(request.endedEarlyFrom)}:{})};
    const payroll=!pay?{model:null,paidHours:0,paidDates:[]}:pay.review||!payable(pay.hours)?{model:pay.model,review:true}:{model:pay.model,hoursPerDay:pay.hours,paidHours:pay.dates.length*pay.hours,paidDates:pay.dates};
    const fields=PAY_FIELDS.filter(name=>request[name]!==undefined&&request[name]!==null);
    if(!bound&&fields.length)report.unboundPayFields.push({...row,fields,payroll});
    if(payroll.review)report.blocksPayroll.push({...row,payroll});
  }
  report.unboundPayFields.sort(byId);report.blocksPayroll.sort(byId);
  return report;
}

export async function runPtoPayAudit(env,{read=readCollection,now=new Date().toISOString()}={}) {
  if(!employeeVaultSecret(env)||!firebaseServiceAccountConfigured(env))throw fail('unconfigured','FIREBASE_SERVICE_ACCOUNT_JSON and the Employee Hub vault key (EMPLOYEE_HUB_DATA_SECRET) are required.');
  return planPtoPayAudit(await read(env,'requests'),now);
}

export function parseArgs(argv) {
  const options={report:'',help:false};
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--dry-run')continue;
    if(arg==='--apply')throw new Error('This audit is read-only. Change pay in the Hub (Requests > Edit pay) so each change is an audited decision.');
    if(arg==='--report'&&argv[i+1]&&!argv[i+1].startsWith('--'))options.report=argv[++i];
    else if(arg==='--help'||arg==='-h')options.help=true;
    else throw new Error('Unknown or incomplete argument: '+arg);
  }
  return options;
}

async function main() {
  let options;
  try{options=parseArgs(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=2;return;}
  if(options.help){console.error('Usage: node scripts/pto-pay-audit.mjs [--report <file>]\nRead-only: lists approved time off whose pay fields no workflow decision set, or whose pay payroll cannot read.');return;}
  let report;
  try{report=await runPtoPayAudit(Object.fromEntries(ENV.map(name=>[name,process.env[name]||''])),{now:new Date().toISOString()});}
  catch(error){console.error(String(error.code||'').startsWith('pto_pay_audit_')?error.message:'The time-off requests could not be read completely. Nothing was changed.');process.exitCode=1;return;}
  const json=JSON.stringify(report,null,2);
  if(options.report)await writeFile(options.report,json+'\n',{mode:0o600});
  process.stdout.write(json+'\n');
  console.error(`READ ONLY (nothing written): ${report.approvedTimeOff} approved time-off requests, ${report.workflowApproved} with workflow pay terms; ${report.unboundPayFields.length} carry pay fields no workflow decision set and ${report.blocksPayroll.length} hold payroll in review. Review them in the Hub (Requests > Edit pay) before the first payroll export.`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
