export function portalTime(value:Date|string|null|undefined):string {
  if(!value)return "Not recorded";
  const date=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(date.valueOf()))return "Needs time review";
  return new Intl.DateTimeFormat("en-US",{timeZone:"America/Denver",dateStyle:"medium",timeStyle:"short"}).format(date)+" MT";
}
/** Employee Hub views the reporting portal may deep-link to (`/employee?view=`). */
export type EmployeeHubView="action_center"|"walkthroughs";
export function employeeHubUrl(view?:EmployeeHubView):string {
  let hub=new URL("https://easygaragecleaning.com/employee");
  const configured=process.env.EGC_PORTAL_ORIGIN;
  if(configured){try{const url=new URL(configured);if(url.protocol==="https:"&&!url.username&&!url.password)hub=new URL("/employee",url);}catch{/* Use the established EGC Hub. */}}
  if(view)hub.searchParams.set("view",view);
  return hub.toString();
}
/** Walkthrough audio is recorded and reviewed only on the Hub visit (Action Center → Portal schedule → Recordings). */
export function employeeHubRecordingsUrl():string {
  return employeeHubUrl("action_center");
}
