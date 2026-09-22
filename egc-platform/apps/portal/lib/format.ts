export function portalTime(value:Date|string|null|undefined):string {
  if(!value)return "Not recorded";
  const date=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(date.valueOf()))return "Needs time review";
  return new Intl.DateTimeFormat("en-US",{timeZone:"America/Denver",dateStyle:"medium",timeStyle:"short"}).format(date)+" MT";
}
export function employeeHubUrl():string {
  const configured=process.env.EGC_PORTAL_ORIGIN;
  if(configured){try{const url=new URL(configured);if(url.protocol==="https:"&&!url.username&&!url.password)return new URL("/employee",url).toString();}catch{/* Use the established EGC Hub. */}}
  return "https://easygaragecleaning.com/employee";
}
